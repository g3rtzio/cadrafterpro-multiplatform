import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LayoutsPanel } from './layouts-panel';

describe('LayoutsPanel', () => {
  let component: LayoutsPanel;
  let fixture: ComponentFixture<LayoutsPanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LayoutsPanel],
    }).compileComponents();

    fixture = TestBed.createComponent(LayoutsPanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
