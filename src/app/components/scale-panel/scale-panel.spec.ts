import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScalePanel } from './scale-panel';

describe('ScalePanel', () => {
  let component: ScalePanel;
  let fixture: ComponentFixture<ScalePanel>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScalePanel],
    }).compileComponents();

    fixture = TestBed.createComponent(ScalePanel);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
