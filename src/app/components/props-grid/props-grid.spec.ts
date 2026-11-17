import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PropsGrid } from './props-grid';

describe('PropsGrid', () => {
  let component: PropsGrid;
  let fixture: ComponentFixture<PropsGrid>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PropsGrid],
    }).compileComponents();

    fixture = TestBed.createComponent(PropsGrid);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
